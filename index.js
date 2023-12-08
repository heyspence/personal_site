const dashDoorViewButton = document.querySelector('.view-dash-door')
const modal = document.querySelector('.modal')


const toggleIHidden = (element) => {
    console.log(element.classList)
    if(element.classList.contains("hidden")){
        element.classList.remove("hidden")
    }else{
        element.classList.add("hidden")
    }
}

dashDoorViewButton.addEventListener("click", ()=>{
    toggleIHidden(modal)
})

modal.addEventListener("click", ()=>{
    toggleIHidden(modal)
})