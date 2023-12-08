const dashDoorViewButton = document.querySelector('.view-dash-door')
const modal = document.querySelector('.modal')
const closeIcon = document.querySelector('.close-icon')

const toggleIHidden = (element) => {
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

closeIcon.addEventListener("click", ()=>{
    toggleIHidden(modal)
})

document.querySelector('.modal-container').addEventListener('click', (e) => {
    e.stopPropagation();
});